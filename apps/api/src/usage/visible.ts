import { usageDays, users } from "@tokenmaxxing/db";
import { and, eq, gte, isNull, lte, type SQL } from "drizzle-orm";
import type { SQLiteSelect } from "drizzle-orm/sqlite-core";

/**
 * Public usage reads. Shadow-banned users' rows must never reach a public
 * aggregate, so every public query over `usage_days` goes through
 * `visibleUsage` instead of re-deriving the users join and ban filter.
 */

interface VisibleUsageOptions {
  /** Inclusive YYYY-MM-DD lower bound; null/undefined = all time. */
  since?: string | null | undefined;
  /** Inclusive YYYY-MM-DD upper bound: the ingest ceiling, so future-dated rows never count. */
  until: string;
}

function visibleUsageFilter({ since, until }: VisibleUsageOptions): SQL | undefined {
  return and(
    isNull(users.shadowBannedAt),
    since === null || since === undefined ? undefined : gte(usageDays.date, since),
    lte(usageDays.date, until),
  );
}

/**
 * Restricts a dynamic `select … from usage_days` to visible rows: joins users
 * and applies the ban filter, the `until` ceiling and the optional `since` bound.
 *
 * @example visibleUsage(db.select(fields).from(usageDays).$dynamic(), { since, until })
 */
function visibleUsage<TQuery extends SQLiteSelect>(query: TQuery, options: VisibleUsageOptions) {
  return query.where(visibleUsageFilter(options)).innerJoin(users, eq(usageDays.userId, users.id));
}

export { visibleUsage, visibleUsageFilter };

export type { VisibleUsageOptions };
