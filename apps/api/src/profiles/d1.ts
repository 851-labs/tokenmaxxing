import { loginAliases, usageDays, usageSourceStats, userAccounts, users } from "@tokenmaxxing/db";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { Effect, Layer, Option } from "effect";

import { DEFAULT_LEADERBOARD_METRIC } from "@tokenmaxxing/api-contract";

import { Drizzle, firstRow } from "../database";
import { authUserColumns, toAuthUser } from "../public-user";
import { singleAggregateRow, sumOf, usageAggregates } from "../usage/aggregates";
import { userRank } from "../usage/ranking";
import { makeProfilesService, ProfilesRepository, ProfilesService } from "./service";
import { usageStreaks } from "./streaks";

const makeD1ProfilesRepository = Effect.fn("makeD1ProfilesRepository")(function* () {
  const database = yield* Drizzle;

  return ProfilesRepository.of({
    findUserByLogin: (login) =>
      Effect.gen(function* () {
        // Logins are minted lowercase (slugifyLogin) and aliases are stored
        // lowercased, so lowercasing the requested one makes lookups
        // case-insensitive on the unique index and the alias key. A current
        // login wins over an alias; the response carries the current login,
        // which is how callers spot an old one.
        const requested = login.toLowerCase();
        const rows = yield* database.use((db) =>
          db
            .select({
              // The oldest linked GitHub identity: the one signup took the
              // login from. A subquery, so extra identities add no rows.
              githubLogin: sql<string | null>`(
                select ${userAccounts.login} from ${userAccounts}
                where ${userAccounts.userId} = ${users.id} and ${userAccounts.provider} = 'github'
                order by ${userAccounts.createdAt}, ${userAccounts.providerAccountId}
                limit 1
              )`,
              shadowBannedAt: users.shadowBannedAt,
              user: authUserColumns,
            })
            .from(users)
            .where(
              or(
                eq(users.login, requested),
                inArray(
                  users.id,
                  db
                    .select({ userId: loginAliases.userId })
                    .from(loginAliases)
                    .where(eq(loginAliases.login, requested)),
                ),
              ),
            )
            .orderBy(desc(sql`${users.login} = ${requested}`))
            .limit(1),
        );

        return firstRow(rows).pipe(
          Option.map((row) => ({
            githubLogin: row.githubLogin,
            shadowBanned: row.shadowBannedAt !== null,
            user: toAuthUser(row.user),
          })),
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
                  sessionCount: sumOf(usageSourceStats.sessionCount),
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
          spendUsd: totalSpendUsd,
          topModel: topModels[0] ?? null,
          totalTokens: totals.totalTokens,
        };
      }),
    daily: (userId, query) =>
      Effect.gen(function* () {
        const key = query.groupBy === "source" ? usageDays.source : usageDays.model;
        const conditions = [
          eq(usageDays.userId, userId),
          gte(usageDays.date, query.since),
          lte(usageDays.date, query.until),
        ];
        if (query.source !== undefined) {
          conditions.push(eq(usageDays.source, query.source));
        }

        const rows = yield* database.use((db) =>
          db
            .select({
              date: usageDays.date,
              key: sql<string>`${key}`.as("group_key"),
              outputTokens: usageAggregates.outputTokens(),
              spendUsd: usageAggregates.spendUsd(),
              totalTokens: usageAggregates.totalTokens(),
            })
            .from(usageDays)
            .where(and(...conditions))
            .groupBy(usageDays.date, sql`group_key`)
            .orderBy(asc(usageDays.date), asc(sql`group_key`)),
        );

        return rows;
      }),
    dailySources: (userId, range) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .selectDistinct({ source: usageDays.source })
            .from(usageDays)
            .where(
              and(
                eq(usageDays.userId, userId),
                gte(usageDays.date, range.since),
                lte(usageDays.date, range.until),
              ),
            )
            .orderBy(asc(usageDays.source)),
        );

        return rows.map((row) => row.source);
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
