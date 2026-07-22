import { usageDays, users } from "@tokenmaxxing/db";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Layer } from "effect";

import { Drizzle } from "../database";
import { LeaderboardRepository } from "./service";

const makeD1LeaderboardRepository = Effect.fn("makeD1LeaderboardRepository")(function* () {
  const database = yield* Drizzle;

  return LeaderboardRepository.of({
    list: (input) =>
      Effect.gen(function* () {
        const spendUsd = sql<number>`sum(${usageDays.costUsd})`.as("spend_usd");
        const totalTokens = sql<number>`sum(${usageDays.totalTokens})`.as("total_tokens_sum");
        const activeDays = sql<number>`count(distinct ${usageDays.date})`.as("active_days");
        const lastDate = sql<string | null>`max(${usageDays.date})`.as("last_date");

        const rows = yield* database.use((db) => {
          const base = db
            .select({
              activeDays,
              lastDate,
              spendUsd,
              totalTokens,
              user: users,
            })
            .from(usageDays)
            .innerJoin(users, eq(usageDays.userId, users.id));

          return (
            input.since === null
              ? base.where(isNull(users.shadowBannedAt))
              : base.where(and(isNull(users.shadowBannedAt), gte(usageDays.date, input.since)))
          )
            .groupBy(usageDays.userId)
            .orderBy(
              input.metric === "spend" ? desc(spendUsd) : desc(totalTokens),
              asc(usageDays.userId),
            )
            .limit(input.limit);
        });

        return rows.map((row, index) => ({
          activeDays: row.activeDays,
          lastDate: row.lastDate,
          rank: index + 1,
          spendUsd: row.spendUsd ?? 0,
          totalTokens: row.totalTokens ?? 0,
          user: {
            avatarUrl: row.user.avatarUrl,
            id: row.user.id,
            login: row.user.login,
            name: row.user.name,
          },
        }));
      }),
  });
});

const LeaderboardRepositoryLive = Layer.effect(
  LeaderboardRepository,
  makeD1LeaderboardRepository(),
);

export { LeaderboardRepositoryLive };
