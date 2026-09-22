import { usageDays, usageSourceStats, users } from "@tokenmaxxing/db";
import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { Effect, Layer, Option } from "effect";

import { DEFAULT_LEADERBOARD_METRIC } from "@tokenmaxxing/api-contract";

import { Drizzle, firstRow } from "../database";
import { publicUserColumns } from "../public-user";
import { singleAggregateRow, usageAggregates } from "../usage/aggregates";
import { userRank } from "../usage/ranking";
import { makeProfilesService, ProfilesRepository, ProfilesService } from "./service";
import { usageStreaks } from "./streaks";

const makeD1ProfilesRepository = Effect.fn("makeD1ProfilesRepository")(function* () {
  const database = yield* Drizzle;

  return ProfilesRepository.of({
    findUserByLogin: (login) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select({ shadowBannedAt: users.shadowBannedAt, user: publicUserColumns })
            .from(users)
            .where(eq(users.login, login))
            .limit(1),
        );

        return firstRow(rows).pipe(
          Option.map((row) => ({ shadowBanned: row.shadowBannedAt !== null, user: row.user })),
        );
      }),
    leaderboardRank: (input) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          userRank(db, { metric: DEFAULT_LEADERBOARD_METRIC, ...input }),
        );

        return rows[0]?.rank ?? null;
      }),
    stats: (userId, window) =>
      Effect.gen(function* () {
        // Rows dated past the ingest ceiling are never real usage; keep them
        // out of every lifetime aggregate.
        const userUsage = and(eq(usageDays.userId, userId), lte(usageDays.date, window.until));
        // One D1 round trip. Batched rows come back as objects keyed by
        // column name, so every statement here must select unique names.
        const [totalRows, sessionRows, fallbackSessionRows, dayRows, topModels, sourceRows] =
          yield* database.use((db) =>
            db.batch([
              db
                .select({
                  deviceCount: usageAggregates.deviceCount(),
                  totalSpendUsd: usageAggregates.spendUsd(),
                  totalTokens: usageAggregates.totalTokens(),
                })
                .from(usageDays)
                .where(userUsage),
              db
                .select({
                  sessionCount: sql<number>`coalesce(sum(${usageSourceStats.sessionCount}), 0)`,
                })
                .from(usageSourceStats)
                .where(eq(usageSourceStats.userId, userId)),
              db
                .select({
                  sessionCount: sql<number>`count(distinct ${usageDays.deviceId} || ':' || ${usageDays.date} || ':' || ${usageDays.source})`,
                })
                .from(usageDays)
                .leftJoin(
                  usageSourceStats,
                  and(
                    eq(usageSourceStats.deviceId, usageDays.deviceId),
                    eq(usageSourceStats.source, usageDays.source),
                  ),
                )
                .where(and(userUsage, isNull(usageSourceStats.deviceId))),
              // Every active day, ascending: active-day count, first/last
              // date, streaks and the peak day all derive from this.
              db
                .select({
                  date: usageDays.date,
                  spendUsd: usageAggregates.spendUsd(),
                })
                .from(usageDays)
                .where(userUsage)
                .groupBy(usageDays.date)
                .orderBy(asc(usageDays.date)),
              db
                .select({
                  model: usageDays.model,
                  spendUsd: usageAggregates.spendUsd().as("model_spend"),
                })
                .from(usageDays)
                .where(userUsage)
                .groupBy(usageDays.model)
                .orderBy(desc(sql`model_spend`))
                .limit(1),
              db
                .selectDistinct({ source: usageDays.source })
                .from(usageDays)
                .where(userUsage)
                .orderBy(asc(usageDays.source)),
            ]),
          );

        const [totals, sessionStats, fallbackSessions] = yield* Effect.all([
          singleAggregateRow(totalRows),
          singleAggregateRow(sessionRows),
          singleAggregateRow(fallbackSessionRows),
        ]);
        const activeDays = dayRows.length;
        const { totalSpendUsd } = totals;
        const sessionCount = sessionStats.sessionCount + fallbackSessions.sessionCount;
        const streaks = usageStreaks(
          dayRows.map((row) => row.date),
          window.today,
        );

        return {
          activeDays,
          avgSpendPerActiveDay: activeDays === 0 ? 0 : totalSpendUsd / activeDays,
          currentStreakDays: streaks.currentStreakDays,
          deviceCount: totals.deviceCount,
          firstDate: dayRows[0]?.date ?? null,
          lastDate: dayRows.at(-1)?.date ?? null,
          longestStreakDays: streaks.longestStreakDays,
          peakDay: peakSpendDay(dayRows),
          sessionCount,
          sources: sourceRows.map((row) => row.source),
          topModel: topModels[0] ?? null,
          totalSpendUsd,
          totalTokens: totals.totalTokens,
        };
      }),
    daily: (userId, query) =>
      Effect.gen(function* () {
        const key = query.groupBy === "source" ? usageDays.source : usageDays.model;

        const conditions: SQL[] = [eq(usageDays.userId, userId)];
        if (query.since !== undefined) {
          conditions.push(gte(usageDays.date, query.since));
        }
        conditions.push(lte(usageDays.date, query.until));

        const rows = yield* database.use((db) =>
          db
            .select({
              costUsd: sql<number>`sum(${usageDays.costUsd})`,
              date: usageDays.date,
              key: sql<string>`${key}`.as("group_key"),
              outputTokens: sql<number>`sum(${usageDays.outputTokens})`,
              totalTokens: sql<number>`sum(${usageDays.totalTokens})`,
            })
            .from(usageDays)
            .where(and(...conditions))
            .groupBy(usageDays.date, sql`group_key`)
            .orderBy(asc(usageDays.date), asc(sql`group_key`)),
        );

        return rows;
      }),
  });
});

const ProfilesRepositoryLive = Layer.effect(ProfilesRepository, makeD1ProfilesRepository());

/** The highest-spend day; the earliest one wins a tie. */
function peakSpendDay(days: readonly { date: string; spendUsd: number }[]) {
  let peak: { date: string; spendUsd: number } | null = null;
  for (const day of days) {
    if (peak === null || day.spendUsd > peak.spendUsd) {
      peak = day;
    }
  }

  return peak;
}

const ProfilesServiceLive = Layer.effect(ProfilesService, makeProfilesService()).pipe(
  Layer.provide(ProfilesRepositoryLive),
);

export { ProfilesRepositoryLive, ProfilesServiceLive };
