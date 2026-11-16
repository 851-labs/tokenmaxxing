import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  LeaderboardMetric,
  LeaderboardResponse,
  LeaderboardWindow,
} from "@tokenmaxxing/api-contract";
import { useState } from "react";

import { Avatar } from "../../../components/ui/avatar";
import { Button } from "../../../components/ui/button";
import { ErrorText } from "../../../components/ui/error-text";
import { cn } from "../../../lib/cn";
import { formatTokens, formatUsd } from "../../../lib/format";
import { leaderboardQueryOptions } from "../../../lib/queries";

type LeaderboardEntry = (typeof LeaderboardResponse.Type)["entries"][number];

/** Tighter gutters on phones, so more columns fit before the table scrolls. */
const CELL = "whitespace-nowrap px-2 py-3 sm:px-3";
const NUMBER_CELL = cn(CELL, "text-right tabular-nums");
const DETAIL_CELL = cn(NUMBER_CELL, "text-muted-foreground");

/**
 * Rank and avatar share one pinned cell while the login and numbers scroll
 * under it; keeping the pinned block this narrow leaves phones room for the
 * data. It inherits its row's background, so rows are painted with opaque
 * mixes rather than alpha tints.
 *
 * At fractional zoom Chromium rounds the scroller's clip outward, so slivers
 * of scrolled text could show past the pinned cell's left edge. It is one
 * cell (no seam between pinned boxes) on its own compositor layer, and a
 * background bleed widens that layer past the clip edge to cover the gap.
 */
const PINNED_CELL = cn(
  // w-px: shrink to its content, so desktop tables give spare width to the data.
  "sticky left-0 z-10 w-px whitespace-nowrap bg-inherit py-3 pr-2 pl-2 will-change-transform sm:pl-3",
  "before:absolute before:inset-y-0 before:right-full before:w-2 before:bg-inherit",
  // A hairline and soft shadow mark the pinned edge once rows scroll under it.
  "group-data-scrolled/board:shadow-[inset_-1px_0_0_var(--color-border),6px_0_8px_-6px_rgb(0_0_0/0.2)]",
);
/** Wide enough for a four-digit rank, so avatars line up in one column. */
const RANK = "inline-block w-12";
/** The pinned cell's `pr-2` plus this `pl-0.5` keep the old 10px avatar–login gap. */
const LOGIN_CELL = "whitespace-nowrap py-3 pr-2 pl-0.5 sm:pr-3";
const HEADER_ROW_BG = "bg-[color-mix(in_oklab,var(--color-muted)_50%,var(--color-background))]";
const BODY_ROW_BG =
  "bg-background hover:bg-[color-mix(in_oklab,var(--color-muted)_40%,var(--color-background))]";

/**
 * The ranked table plus a "Load more" button that appends the next page under
 * the same metric and window. The API ranks every page against the full
 * board, so ranks continue across pages; the button disappears on the last.
 */
function Leaderboard({ metric, window }: { metric: LeaderboardMetric; window: LeaderboardWindow }) {
  const { data, fetchNextPage, hasNextPage, isFetchNextPageError, isFetchingNextPage } =
    useSuspenseInfiniteQuery(leaderboardQueryOptions(metric, window));
  const entries = uniqueByLogin(data.pages.flatMap((page) => page.entries));

  return (
    <>
      <LeaderboardTable entries={entries} />
      {hasNextPage ? (
        <div className="flex flex-col items-center gap-2 px-4 pt-4">
          <Button
            aria-busy={isFetchingNextPage}
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
          {isFetchNextPageError ? <ErrorText>Couldn't load more rows. Try again.</ErrorText> : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * Rows can shift between page fetches (someone syncs and moves up), so a user
 * may come back on two pages; keep their first row so React keys stay unique.
 */
function uniqueByLogin(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.user.login)) {
      return false;
    }
    seen.add(entry.user.login);
    return true;
  });
}

function LeaderboardTable({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const [scrolled, setScrolled] = useState(false);

  if (entries.length === 0) {
    return (
      <div className="border-y border-border">
        <p className="p-6 text-sm text-muted-foreground">
          Nobody on the board yet — be the first to sync.
        </p>
      </div>
    );
  }

  return (
    // Phones get every column: the table scrolls sideways inside this frame
    // (never the page), and it is focusable so keyboards can scroll it too.
    <div
      aria-label="Leaderboard table"
      className="group/board overflow-x-auto overscroll-x-contain border-y border-border outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      data-scrolled={scrolled ? "" : undefined}
      onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 0)}
      role="region"
      tabIndex={0}
    >
      {/* Separate borders live on the cells, so they travel with the pinned
          cell; collapsed borders belong to the table and some engines leave
          them behind when a sticky cell moves. */}
      <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Leaderboard of top users by LLM token spend and usage</caption>
        <thead>
          <tr
            className={cn(
              "text-left text-xs uppercase tracking-wider text-muted-foreground [&>th]:border-b [&>th]:border-border",
              HEADER_ROW_BG,
            )}
          >
            <th className={cn(PINNED_CELL, "font-medium")} scope="col">
              {/* Spans the avatar too; the spacer keeps the pinned width. */}
              <span className={RANK}>#</span>
              <span aria-hidden="true" className="inline-block w-6" />
            </th>
            <th className={cn(LOGIN_CELL, "font-medium")} scope="col">
              User
            </th>
            <th className={cn(NUMBER_CELL, "font-medium")} scope="col">
              Spend
            </th>
            <th className={cn(NUMBER_CELL, "font-medium")} scope="col">
              Tokens
            </th>
            <th className={cn(NUMBER_CELL, "font-medium")} scope="col">
              Active days
            </th>
            <th className={cn(NUMBER_CELL, "font-medium")} scope="col">
              Last active
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              className={cn(
                "transition-colors [&>td]:border-b [&>td]:border-border last:[&>td]:border-b-0",
                BODY_ROW_BG,
              )}
              key={entry.user.login}
            >
              <td className={PINNED_CELL}>
                <div className="flex items-center">
                  <span className={cn(RANK, "font-mono tabular-nums text-muted-foreground")}>
                    {entry.rank}
                  </span>
                  {/* Pointer shortcut only: the login link beside it is the tab stop and name. */}
                  <Link
                    aria-hidden="true"
                    className="flex"
                    params={{ user: entry.user.login }}
                    tabIndex={-1}
                    to="/$user"
                  >
                    <Avatar size={24} src={entry.user.avatarUrl} />
                  </Link>
                </div>
              </td>
              <td className={LOGIN_CELL}>
                <Link
                  className="font-medium hover:underline"
                  params={{ user: entry.user.login }}
                  to="/$user"
                >
                  {entry.user.login}
                </Link>
              </td>
              <td className={cn(NUMBER_CELL, "font-mono")}>{formatUsd(entry.spendUsd)}</td>
              <td className={cn(NUMBER_CELL, "font-mono")}>{formatTokens(entry.totalTokens)}</td>
              <td className={DETAIL_CELL}>{entry.activeDays}</td>
              <td className={DETAIL_CELL}>{entry.lastDate ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { Leaderboard };
