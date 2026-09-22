import { usageDays, users } from "@tokenmaxxing/db";
import { asc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { LeaderboardMetric, LeaderboardWindow } from "@tokenmaxxing/api-contract";

import { trailingWindowStart } from "../date-keys";
import { publicUserColumns } from "../public-user";
import { usageAggregates, usageMetric } from "./aggregates";
import { visibleUsage } from "./visible";

/**
 * The one user ranking shared by the leaderboard, the stats page, and profile
 * ranks. Windows are UTC day keys compared lexicographically against the
 * opaque YYYY-MM-DD local-time buckets — a user's "today" can wobble ±1 day at
 * window edges; accepted.
 */

interface RankingOptions {
  metric: LeaderboardMetric;
  /** Inclusive YYYY-MM-DD lower bound; null = all time. */
  since: string | null;
  /** Inclusive YYYY-MM-DD upper bound (the ingest ceiling). */
  until: string;
}

const LEADERBOARD_WINDOW_DAYS = {
  "30d": 30,
  "7d": 7,
  all: null,
} as const satisfies Record<LeaderboardWindow, number | null>;

/** Inclusive lower bound for a leaderboard window; null = all time. */
function leaderboardWindowStart(window: LeaderboardWindow, now: Date): string | null {
  const days = LEADERBOARD_WINDOW_DAYS[window];
  return days === null ? null : trailingWindowStart(days, now);
}

/** Per-user visible totals with a unique 1-based rank (ties broken by user id). */
function rankedUsers(db: DrizzleD1Database, { metric, since, until }: RankingOptions) {
  return visibleUsage(
    db
      .select({
        activeDays: usageAggregates.activeDays().as("active_days"),
        lastDate: usageAggregates.lastDate().as("last_date"),
        rank: sql<number>`row_number() over (
        order by ${usageMetric(metric)} desc, ${usageDays.userId} asc
      )`.as("leaderboard_rank"),
        spendUsd: usageAggregates.spendUsd().as("spend_usd"),
        totalTokens: usageAggregates.totalTokens().as("total_tokens_sum"),
        userId: usageDays.userId,
      })
      .from(usageDays)
      .$dynamic(),
    { since, until },
  )
    .groupBy(usageDays.userId)
    .as("ranked_users");
}

/** The first `limit` ranked users with their public identity, best first. */
function topUsers(db: DrizzleD1Database, options: RankingOptions & { limit: number }) {
  const ranked = rankedUsers(db, options);

  return db
    .select({
      activeDays: ranked.activeDays,
      lastDate: ranked.lastDate,
      rank: ranked.rank,
      spendUsd: ranked.spendUsd,
      totalTokens: ranked.totalTokens,
      user: publicUserColumns,
    })
    .from(ranked)
    .innerJoin(users, eq(ranked.userId, users.id))
    .orderBy(asc(ranked.rank))
    .limit(options.limit);
}

/** A single user's rank, or no row when they have no visible usage in the window. */
function userRank(db: DrizzleD1Database, options: RankingOptions & { userId: string }) {
  const ranked = rankedUsers(db, options);

  return db
    .select({ rank: ranked.rank })
    .from(ranked)
    .where(eq(ranked.userId, options.userId))
    .limit(1);
}

export { leaderboardWindowStart, rankedUsers, topUsers, userRank };

export type { RankingOptions };
