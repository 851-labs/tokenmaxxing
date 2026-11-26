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

/**
 * `visibleUsage` with the join order pinned for scans of a whole date window:
 * SQLite never reorders tables across a `CROSS JOIN`, so it walks the visible
 * users and reads each one's days through `usage_days_user_date_cost_tokens_idx`.
 * Left to choose, the planner drives such a scan from `usage_days_date_idx`,
 * which looks up every row in the window (banned users' included) in the table
 * and then its user: over a year in production that reads four times the rows
 * and takes over three times as long. A query that selects only user, date,
 * cost and total tokens never touches the table at all.
 *
 * @example visibleUsageByUser(db.select(fields).from(users).$dynamic(), { since, until })
 */
function visibleUsageByUser<TQuery extends SQLiteSelect>(
  query: TQuery,
  options: VisibleUsageOptions,
) {
  return query
    .crossJoin(usageDays)
    .where(and(eq(usageDays.userId, users.id), visibleUsageFilter(options)));
}

export { visibleUsage, visibleUsageByUser, visibleUsageFilter };

export type { VisibleUsageOptions };
